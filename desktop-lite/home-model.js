/* 首页和「全部视频」页的纯逻辑：不碰界面、不碰存储，单测在 claude-chat/home-model.test.js。 */
(function (root) {
  /* 「全部视频」是个虚拟标签，跟视频工作台一样复用标签页和前进后退。名字里不带斜杠和点，
     不会被当成路径或文件类型去解析，也不可能和笔记库里的真实文件撞名。 */
  const ALL_VIDEOS_TAB = "__all_videos__";
  const ALL_VIDEOS_EXTENSION = "allvideos";

  const NOT_A_NOTE = /^(png|jpe?g|gif|webp|svg|avif|pdf)$/i;
  const MAX_OPENED = 30;
  const RECENT_LIMIT = 6;

  function parseOpened(raw) {
    try {
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.filter((item) => typeof item?.path === "string" && typeof item.at === "number");
    } catch {
      return [];
    }
  }

  function recordOpened(list, path, at) {
    return [{ path, at }, ...list.filter((item) => item.path !== path)].slice(0, MAX_OPENED);
  }

  /** 这个文件属于哪个视频工程。笔记库根目录当工程的情况不算：那样所有笔记都成了工程文件。 */
  function projectOf(path, projects) {
    let owner = null;
    for (const project of projects) {
      if (!project.path || !path.startsWith(`${project.path}/`)) continue;
      if (!owner || project.path.length > owner.path.length) owner = project;
    }
    return owner;
  }

  /** 工程的 work/ 目录是出片过程的中间产物，不是人写的东西。 */
  function isGenerated(path, projects) {
    return projects.some((project) => path.startsWith(project.path ? `${project.path}/work/` : "work/"));
  }

  /* 「继续你的工作」要回答的是「我刚才在做什么」，只看修改时间答不了：同步、定时任务、
     AI 出片都会改文件，一条视频能把整个列表占满。所以人打开过的优先，不够再按修改
     时间补；补的时候先放工程外的笔记，配套文档已经由视频卡片代表了。 */
  function recentFiles({ files, opened = [], projects = [], limit = RECENT_LIMIT }) {
    const notes = files.filter((file) => !NOT_A_NOTE.test(file.extension || "") && !isGenerated(file.path, projects));
    const byPath = new Map(notes.map((file) => [file.path, file]));
    const result = [];
    const seen = new Set();
    const add = (file, touchedAt) => {
      if (result.length >= limit || seen.has(file.path)) return;
      seen.add(file.path);
      result.push({ ...file, touchedAt });
    };
    for (const entry of opened) {
      const file = byPath.get(entry.path);
      if (file) add(file, entry.at);
    }
    const newestFirst = [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const file of newestFirst) if (!projectOf(file.path, projects)) add(file, file.updatedAt);
    for (const file of newestFirst) add(file, file.updatedAt);
    return result;
  }

  /** 列表里跟在标题后面的那段说明：「口播稿」要说清是哪条片子的，别的说明在哪个文件夹。 */
  function contextOf(file, projects) {
    const owner = projectOf(file.path, projects);
    if (owner) return owner.title || owner.name || "";
    const parts = file.path.split("/");
    return parts.length > 1 ? parts[parts.length - 2] : "";
  }

  function filterVideos(projects, query) {
    const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return projects;
    return projects.filter((project) => {
      const haystack = `${project.title ?? ""} ${project.name ?? ""} ${project.path ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  function relativeTime(seconds, now = Date.now()) {
    if (!seconds) return "";
    const date = new Date(seconds * 1000);
    const today = new Date(now);
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    // 用日历算天数差，不用毫秒除以 24 小时：跨夏令时和跨月都不会错
    const days = Math.round((dayStart(today) - dayStart(date)) / 86400000);
    const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (days <= 0) return `今天 ${clock}`;
    if (days === 1) return `昨天 ${clock}`;
    const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
    return date.getFullYear() === today.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
  }

  root.InkfellowHomeModel = {
    ALL_VIDEOS_TAB,
    ALL_VIDEOS_EXTENSION,
    parseOpened,
    recordOpened,
    recentFiles,
    contextOf,
    filterVideos,
    relativeTime,
  };
})(globalThis);
