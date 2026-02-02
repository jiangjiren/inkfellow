export default function Home() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <section className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight">Mindflow Insight</h1>
        <p className="mt-4 text-lg text-gray-600">
          This is the mother project. New pages will be generated automatically.
        </p>
        <div className="mt-8 rounded-2xl border border-gray-200 p-6">
          <p className="font-medium">How to add a page</p>
          <p className="mt-2 text-gray-600">Create: <code>src/app/&lt;slug&gt;/page.tsx</code></p>
          <p className="mt-1 text-gray-600">Example: <code>src/app/landing-1/page.tsx</code></p>
        </div>
      </section>
    </main>
  );
}
