# 视频工作台接口约定（v1）

三方共用：`video-director` 引擎、Tauri 层（`src-tauri/src/video_workbench.rs`）、前端（`desktop-lite/video-workbench*.js`）。
改动本文件要同时通知另外两方。

## 产品规则（已定，不再讨论）

1. 工作台是审片改稿台，不是时间线剪辑器。AI 流程不加任何确认环节，不打开工作台时出片行为不变。
2. 主视图是逐句脚本，轨道只读、只用来定位。
3. 界面只显示最新版本；磁盘保留最近 3 个正式版，由引擎在出片成功后自动清理。
4. 工作台不写 `edl.json`、`build_edl.py`、`口播稿.md`。人工改动只写 `edits.json`，引擎读取时叠加。
5. 缩略图等缓存放在 vault 外（vault 由 Syncthing 同步）。
6. 任何日志、缓存写失败都不能让出片失败。

## 工程目录

工程 = 含 `edl.json` 的文件夹。

```
<工程>/
  edl.json              AI 或 build_edl.py 生成，工作台只读
  edits.json            工作台写：人工改动 + 给 AI 的意见（进 git）
  manifest.json         素材清单（可能没有）
  口播稿.md 制作说明.md 发布文案.md
  out/<name>_v<N>.mp4   正式版   out/<name>_preview.mp4   预览   out/封面*.jpg|png
  work/plan.json        最近一次规划的时间表（可能和最新成片不一致）
  work/versions/<成片文件名去后缀>.plan.json   该成片对应的时间表快照
  work/journal.jsonl    进度日志（不进 git）
  work/edits_status.json 叠加结果（不进 git）
  work/samples/<beat>_<hash>.mp4   本段小样
  work/.render.lock     出片锁
```

## edits.json

```jsonc
{
  "version": 1,
  "revision": 7,           // 每次写入 +1，Tauri 层维护
  "edits": [ /* 见下，每个目标最多一条，同目标由前端合并 */ ],
  "notes": [               // 给 AI 的意见，引擎忽略
    {"id":"n_x","beat":"b08","shot":null,"time":41.2,"text":"这段节奏太慢","createdAt":1762250000,"sentAt":null}
  ]
}
```

Edit 通用字段：`id`、`op`、`createdAt`。`base` 记录改动前 `edl.json` 里的**原始值**（未解析的 `src` 原文），用于冲突判断。

| op | 定位字段 | base | value | 叠加规则 |
|---|---|---|---|---|
| `set_say` | `beat` | `{say}` | `{say, say_tts?}` | 替换 `say`。value 没带 `say_tts` 时删除原 `say_tts`（否则会读旧文字） |
| `set_say_tts` | `beat` | `{say_tts?}` | `{say_tts}` | 只改读音文字，字幕不变 |
| `delete_beat` | `beat` | `{say}` | 无 | 删除整段。不允许删光所有段 |
| `replace_shot` | `beat`,`shot` | `{src?,in?,scene?}` | `{src,in?,fit?,focus?,focus_y?,motion?,speed?}` | 保留旧镜头的 `len`、`cut_at_word`，其余取 value。新素材是照片时去掉 `in`、`speed`；是视频时去掉 `motion`；`audio` 重置为 mute。旧镜头是动画时丢弃全部动画参数 |
| `set_voice` | 无 | 涉及键的旧值 | `{speed?}` 或 `{rate?}` | 合并进顶层 `voice` |

定位和冲突（按顺序判断）：

1. 按 `beat` id 找段。找不到或 `base.say` 对不上时，全片找 `say == base.say` 的唯一一段并改投过去（AI 重新编号时不丢改动）。没有这样的一段时：id 还在就留在原段，由第 3 条报 `base_changed`（AI 改了这句，要带上新文字让用户选）；id 也没了才是 `beat_missing`。
2. 目标当前值已等于 `value` → `absorbed`（AI 已吸收，不算冲突）。
3. 当前值等于 `base` → 应用。否则 → 冲突 `base_changed`，不应用。
4. `replace_shot` 的 `shot` 下标对不上 `base` 时，在本段找 `src`+`in` 相同的唯一镜头改投；找不到 → 冲突 `shot_missing`。
5. `value` 不合法 → 冲突 `invalid`。

`set_say` 之后本段里引用不到的 `cut_at_word`、`at_word` 必须降级，不能让出片报错（`WordClock.at` 找不到词会抛错）：
镜头的 `cut_at_word` 删除；字卡的 `at_word` 换成 `at: 0.15`；动画参数里的 `at_word` 换成 `at: 0.5`。每处写一条 warning。

变体方案：`edl.json` 对应 `edits.json`；其它 `foo.json` 对应 `foo.edits.json`。

## work/edits_status.json

```jsonc
{"version":1,"revision":7,"at":1762250000.0,
 "applied":["e1"],"absorbed":["e2"],
 "conflicts":[{"id":"e3","reason":"base_changed","message":"这句已被 AI 改过","current":{"say":"…"}}],
 "warnings":["第 3 段第 2 个镜头的 cut_at_word「住半年」在新口播里找不到，已改为按比例切换"]}
```

## 引擎新增命令

所有机器可读输出是单独一行：`@@VD {json}`，其余行照旧给人看。

| 命令 | 作用 | 结果行 |
|---|---|---|
| `vd edits status <edl> [--json]` | 只算叠加结果并写 status，不渲染，不解析素材 | `@@VD {"edits":{…status…}}` |
| `vd edits clear <edl> [--ids e1,e2]` | 删除已吸收的改动（给 AI 用） | `@@VD {"cleared":[…]}` |
| `vd render <edl> --beat <id>` | 本段小样：半分辨率，带配音、字幕、字卡、音效。不写 `work/plan.json`，不占出片锁，不进 `out/` | `@@VD {"video":"…","beat":"b03","duration":3.2,"cached":false}` |
| `vd render <edl>`（已有） | 增加结果行和快照、清理 | `@@VD {"video":"…","preview":false,"duration":72.1,"plan":"…","pruned":["…"]}` |
| `vd thumbs shots <edl> --video <mp4> --out <dir>` | 按该成片的时间表，从成片取每个镜头中点帧 | 每张 `@@VD {"thumb":"…","shot":3}`；末行 `@@VD {"thumbsDone":true,"count":20}` |
| `vd thumbs sources <文件夹或文件…> --out <dir>` | 枚举素材（不递归）并生成缩略图 | 每个 `@@VD {"source":{"path","name","kind","w","h","dur","created","sizeMb","thumb"}}`；末行同上 |

`thumbs` 约定：宽 270 的 jpg；低进程优先级（不等待其它出片，靠优先级让路，否则打开选素材会卡住）；已存在则跳过并照常输出；单个文件失败只跳过它，不影响列表。`thumbs shots` 优先用该成片的快照，老工程没有快照时退回 `work/plan.json`。缓存文件名含路径、大小、修改时间的哈希。

## work/journal.jsonl

每行一个事件，写失败静默；超过 1MB 时保留最后 2000 行。

```jsonc
{"v":1,"ts":1762250000.1,"run":"a1b2c3d4","pid":1234,"cmd":"render","stage":"shots","status":"progress",
 "done":4,"total":20,"preview":false,"msg":null,"video":null}
```

- `cmd`：`probe` `voice` `validate` `render` `sample` `qa` `cover`
- `stage`：`run`（整条命令）；render 另有 `plan` `shots` `assemble` `mix` `final`
- `status`：`start` `progress` `done` `error`。整条命令的 `done` 带 `video`、`secs`；`error` 带 `msg`。

## 版本与清理

- 新版本号 = `out/` 里现有最大 N + 1（不再填空位）。
- 出片成功后把时间表写到 `work/versions/<stem>.plan.json`，额外字段 `video`、`renderedAt`、`editsRevision`、`editsApplied`（已进这版成片的改动 id，前端靠它算还有多少待出片）。预览同样写（`<name>_preview.plan.json`）。
- `plan.beats[]` 增加 `id`（edl 没写时用 `b%02d`）；`plan.shots[]` 确保有 `beat`、`idx`、`kind`、`path`、`in`、`start`、`frames`，动画镜头有 `scene`；`plan.texts[]` 增加 `beat`（钩子大字为 `null`）。
- 清理：正式版成功后只留 N 最大的 `keep_versions` 个（`vd config`，默认 3，0 表示不清理）。只动严格匹配 `<name>_v<N>.mp4` 的文件及其快照，绝不动预览、封面、改过名的文件；`--out` 自定义输出时不清理；删除失败只记日志。
- `last_render.json` 必须指向真实产物。

## 并发

- `vd render`（正式和预览）在 `work/.render.lock` 记 pid；活着的 pid 持锁时报错退出（文案：这个工程正在出片，等它结束再试），死 pid 自动清除。
- 全局 `~/.video-director/running/<pid>.json` 记正在出片的进程，结束时删除。
- 判断进程是否活着不能用 `os.kill(pid, 0)`：Windows 上信号 0 就是 CTRL_C_EVENT，跨控制台的活进程也会报错，出片锁就失效了。要用 `OpenProcess` + `GetExitCodeProcess`。
- 镜头缓存的临时文件名带 pid，避免两个进程撞名。
- 成片和预览都先写临时文件，再原子替换目标，避免覆盖正在播放的文件。替换失败时重试，仍失败则保留临时文件并报明路径。

## Tauri 命令

路径参数一律是 vault 相对路径（`/` 分隔），返回字段 camelCase。`abs` 是绝对路径，前端用 `convertFileSrc`。

| 命令 | 入参 | 返回 |
|---|---|---|
| `video_env` | | `{ok, vdPath, python, message}` |
| `video_list_projects` | | `{projects:[{path,name,updatedAt,latestVideo,hasPlan}]}` |
| `video_read_project` | `{path}` | `VideoProject`（见下） |
| `video_read_plan` | `{path,version}` | `{plan, planSource}`，`version` 是成片文件名 |
| `video_write_edits` | `{path,edits,expectedRevision}` | `{revision}`；版本不符返回错误字符串 `REVISION_CONFLICT` |
| `video_list_sources` | `{path}` | `{folders:[{abs,label,exists}],assets:[manifest 素材…,used:[beatId]]}` |
| `video_pick_source` | `{path,mode}`（`mode` 是 `file` 或 `folder`） | `{abs,isFolder}` 或 `null`（系统选择框，选中后放行） |
| `video_start_job` | `{path,kind,args}` | `{jobId}` |
| `video_cancel_job` | `{jobId}` | `{cancelled}`（结束整棵进程树） |
| `video_cache_dir` | `{path}` | `{abs}` |

```ts
type VideoProject = {
  path: string; abs: string; name: string;
  edl: object; edlMtime: number;
  edits: object | null;          // 没有文件时为 null，revision 视为 0
  editsStatus: object | null;
  versions: {name:string; abs:string; n:number|null; kind:"final"|"preview"|"other";
             size:number; mtime:number; hasPlan:boolean}[];  // final 按 n 降序，再 preview，再 other
  latest: string | null;         // 最大 n 的 final；预览比它新时取预览（AI 正在迭代）；两者都没有时取最新的 other（比如 _v1.2）
  plan: object | null;           // latest 的快照，否则 work/plan.json
  planSource: "snapshot" | "latest" | "none";
  journal: object[];             // 末尾 200 条
  running: {pid,cmd,stage,done,total,preview,startedAt} | null;  // 进程确实活着才返回
  facts: {manifest:boolean; script:boolean; notes:boolean; publish:boolean; voiceCount:number;
          plan:boolean; preview:boolean; qa:boolean; final:boolean; cover:boolean; buildScript:boolean};
  files: {script:string|null; publish:string|null; notes:string|null};  // vault 相对路径
  covers: {name,abs,mtime,size}[];
  missingSources: string[];      // plan 和 edl 里确认不存在的素材绝对路径；检查超时的不算（机械盘唤醒要几秒）
};
```

`video_read_project` 负责放行资源协议：只放行 plan、edl 引用的媒体文件（`allow_file`，按扩展名过滤），不放行整个盘。
`video_list_sources` 对素材文件夹用 `allow_directory(dir, false)`，不递归。缓存目录递归放行。

`video_start_job` 的 kind：

| kind | args | 实际运行 |
|---|---|---|
| `thumbs_shots` | `{video}`（成片文件名） | `vd thumbs shots`，输出到缓存目录 `shots/<成片名>/` |
| `thumbs_sources` | `{folder}`（绝对路径） | `vd thumbs sources`，输出到缓存目录 `sources/` |
| `sample` | `{beat}` | `vd render edl.json --beat <beat>` |
| `render` | `{}` | `vd render edl.json` 成功后接 `vd qa <成片> edl.json` |
| `edits_status` | `{}` | `vd edits status edl.json --json` |

- 同一工程同时只跑一个 `render`，同一工程同一段只跑一个 `sample`；`thumbs_*` 全局排队，一次一个。
- 校验：`beat` 只能是 `[A-Za-z0-9_-]+`；`video` 必须是该工程 `out/` 下的文件。
- 版本名前缀要按引擎规则净化 `edl.project`（空白和 `\/:*?"<>|` 连续替换成一个下划线）。
- 任务失败时 `message` 带子进程最后几行输出，界面要能告诉用户真正的原因。
- 环境和 `spawn_agent` 一致（`configure_proxy_environment`、`hide_command_window`），另设 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`。
- 优先用 `~/.video-director/venv/Scripts/python.exe`，其次 `py -3`、`python`。**不能用 `python3`**（这台机器上是静默退出的 Store 存根）。
- vd.py 默认路径 `~/.claude/skills/video-director/scripts/vd.py`，可用环境变量 `INKFELLOW_VD_PATH` 覆盖。

### 事件

```ts
// 任务事件
"video-job": {jobId, project, kind,
              status:"start"|"line"|"event"|"done"|"error"|"cancelled",
              line?:string, event?:object, code?:number, message?:string}
// 工程文件变化（同工程 300ms 合并）
"video-project-changed": {project, kinds:string[]}  // kinds: edl edits status plan journal versions out docs
```

只监听这些路径：`edl.json`、`edits.json`、`work/plan.json`、`work/journal.jsonl`、`work/edits_status.json`、`work/versions/*.plan.json`、`out/*.{mp4,jpg,jpeg,png,webp}`、`口播稿.md`、`制作说明.md`、`发布文案.md`。`work/segs` 等不触发。

## 发给 AI 的修改单

前端通过现有 `note-ask` 通道发送，文本格式：

```
【视频修改单】工程：<vault 相对路径>（当前 <成片文件名>）
1. b03 第1个镜头（00:13–00:16，<素材名> 18.3秒起）：<意见>
2. b08（00:41）：<意见>
工作台还有 2 处人工改动已写入 edits.json，出片时会自动叠加，不用手改。
```

引擎 `SKILL.md` 要写明 AI 收到修改单后的处理方式。

## v2：交互重做新增（2026-11-04）

### 帧条：素材上滑动鼠标就能预览

`vd thumbs sources <文件夹或文件…> --out <dir> [--strips N]`：不带 `--strips` 时行为不变。带上时，每个视频在素材行之后紧跟一行帧条（多线程处理，不同文件之间的先后不固定，同一文件一定是素材行在前）：

```
@@VD {"strip":{"path":"素材绝对路径","image":"帧条绝对路径","frames":10,"tileW":200,"tileH":356}}
```

- 帧条是一张横向拼图 jpg，从左到右 N 格，第 i 格（从 0 开始）对应素材的第 `(i + 0.5) / N * 时长` 秒。
- 每格宽 200 像素，高按素材比例（偶数）。已有的旋转信息要生效（竖拍素材要是竖的）。
- 只解码关键帧，一个文件要在 1 秒量级完成（手机 4K 原片），因为一个素材夹可能有上百个文件。
- 按路径、大小、修改时间缓存，已存在则跳过并照常输出；写临时文件再替换；单个失败只跳过；低进程优先级。
- 不能等全部列完才生成帧条：一百多个文件时要等好几分钟，用户早就在滑了。结束行 `{"thumbsDone":true,...}` 在最后。

`thumbs_sources` 任务传 `--strips 10`。用户关闭选素材面板时界面会调用 `video_cancel_job`，已生成的帧条留作缓存。

### 工程列表

`video_list_projects` 每项增加：`title`（`edl.project`，没有时用文件夹名）、`cover`（`out/` 里最新的封面绝对路径，没有时为 `null`）、`durationSec`（最新成片时长，优先读 `work/last_render.json`，其次快照和 `plan.json`，都没有时为 `null`）。按 `updatedAt` 取 edl、最新成片两者较新的时间，降序排列。

### 前端对外接口（`InkfellowVideoWorkbench`）

`listProjects()` 返回工程数组（同上字段）；`tabForProject(path)`、`isProject(path)`、`isProjectTab(path)`、`projectOfTab(tabPath)`、`EXTENSION` 不变。

### 聊天里的「打开视频」

助手消息文本里出现 `…/out/…​.mp4` 路径时，在消息末尾显示「打开视频」卡片（只在桌面端）。点击后 iframe 用现有桥接发 `{type:"agent-open-video", path}`，壳把路径换算成 vault 相对路径，取 `/out/` 之前的部分作为工程；是视频工程就打开工作台，否则提示。
