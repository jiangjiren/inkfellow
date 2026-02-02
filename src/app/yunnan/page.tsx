const spots = [
  {
    name: "翠湖公园",
    desc: "昆明市中心的湖景公园，冬季红嘴鸥打卡地。",
    img: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "云南大学（老校区）",
    desc: "银杏林+民国建筑，文艺出片。",
    img: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "金马碧鸡坊",
    desc: "城市地标，夜景最有氛围。",
    img: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "滇池·海埂大坝",
    desc: "看日落、喂海鸥、沿湖散步。",
    img: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "西山龙门",
    desc: "登高俯瞰滇池，轻徒步。",
    img: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "官渡古镇",
    desc: "老昆明味道，适合慢逛吃小吃。",
    img: "https://images.unsplash.com/photo-1467269204594-9661b134dd2b?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "捞鱼河公园（呈贡）",
    desc: "大草地+湖景，亲子放风首选。",
    img: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "斗南花市",
    desc: "亚洲最大鲜花市场，拍照超好看。",
    img: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "石林",
    desc: "世界自然遗产，喀斯特奇观。",
    img: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "九乡",
    desc: "溶洞+地下河，亲子探险感。",
    img: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "大观公园",
    desc: "名联与湖景，适合散步。",
    img: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?q=80&w=1200&auto=format&fit=crop",
  },
  {
    name: "圆通山",
    desc: "春季樱花，动物园适合亲子。",
    img: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=1200&auto=format&fit=crop",
  },
];

const play = [
  "亲子线路：捞鱼河公园 → 斗南花市 → 翠湖",
  "城市慢游：云大老校区 → 文林街 → 金马碧鸡坊夜景",
  "自然轻徒步：西山龙门 → 海埂大坝日落",
  "一日郊游：石林/九乡二选一",
];

export default function YunnanPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50 text-gray-900">
      <section className="mx-auto max-w-6xl px-6 py-16">
        <p className="text-sm font-medium text-emerald-600">云南·昆明旅行介绍</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">昆明旅行地图：热门景点 + 玩法路线</h1>
        <p className="mt-4 text-lg text-gray-600">
          这是一份“图文并茂”的昆明旅行清单，覆盖市区、呈贡、郊区热门打卡点，并给出最常用的玩法组合。
        </p>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {spots.map((s) => (
            <div key={s.name} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <img src={s.img} alt={s.name} className="h-44 w-full object-cover" />
              <div className="p-5">
                <h3 className="text-xl font-semibold">{s.name}</h3>
                <p className="mt-2 text-gray-600">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border border-emerald-100 bg-emerald-50 p-6">
          <h2 className="text-2xl font-semibold">热门玩法（直接抄作业）</h2>
          <ul className="mt-4 space-y-2 text-gray-700">
            {play.map((p) => (
              <li key={p}>• {p}</li>
            ))}
          </ul>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h3 className="text-xl font-semibold">必吃</h3>
            <p className="mt-2 text-gray-600">过桥米线、汽锅鸡、烤乳扇、野生菌火锅、豆花米线。</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h3 className="text-xl font-semibold">避坑</h3>
            <p className="mt-2 text-gray-600">雨季道路湿滑慎自驾；高海拔注意保暖防晒；热门点周末人多建议早去。</p>
          </div>
        </div>

        <p className="mt-12 text-sm text-gray-500">
          这是测试页：/yunnan。后续我会按你的需求持续生成新页面并自动部署。
        </p>
      </section>
    </main>
  );
}
