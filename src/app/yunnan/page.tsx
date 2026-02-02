export default function YunnanPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-slate-50 text-gray-900">
      <section className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm font-medium text-emerald-600">云南·旅行介绍</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight">在云南，把时间慢下来</h1>
        <p className="mt-4 text-lg text-gray-600">
          这里有四季同框的雪山与湖泊、古城与雨林。适合亲子、情侣、轻徒步与慢节奏旅居。
        </p>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {[
            { title: "昆明", desc: "春城气候宜人，适合亲子与城市慢游。" },
            { title: "大理", desc: "洱海骑行、苍山徒步、白族风情。" },
            { title: "丽江", desc: "古城夜景与雪山之约，拍照出片。" },
          ].map((card) => (
            <div key={card.title} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <h3 className="text-xl font-semibold">{card.title}</h3>
              <p className="mt-2 text-gray-600">{card.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-2xl border border-emerald-100 bg-emerald-50 p-6">
          <h2 className="text-2xl font-semibold">推荐路线（3-5天）</h2>
          <ul className="mt-4 space-y-2 text-gray-700">
            <li>Day1：昆明老城 · 翠湖/云大/金马碧鸡坊</li>
            <li>Day2：大理古城 · 洱海骑行 · 日落</li>
            <li>Day3：丽江古城 · 玉龙雪山 · 蓝月谷</li>
            <li>Day4-5（可选）：香格里拉/雨林徒步</li>
          </ul>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h3 className="text-xl font-semibold">必吃</h3>
            <p className="mt-2 text-gray-600">过桥米线、汽锅鸡、烤乳扇、野生菌火锅。</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-6">
            <h3 className="text-xl font-semibold">避坑</h3>
            <p className="mt-2 text-gray-600">高海拔注意防晒与保暖；雨季道路湿滑，谨慎自驾。</p>
          </div>
        </div>

        <p className="mt-12 text-sm text-gray-500">
          这是测试页：/yunnan。后续我会按你的需求持续生成新页面并自动部署。
        </p>
      </section>
    </main>
  );
}
