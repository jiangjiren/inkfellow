import path from 'path';
import type { NextConfig } from 'next';
import withPWA from '@ducanh2912/next-pwa';

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {
    root: path.join(__dirname),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    cpus: 1,
    workerThreads: true,
    staticGenerationMaxConcurrency: 1,
    // 经过 proxy.ts 中间件的请求体默认上限 10MB；文件导入分批最大 ~20MB，
    // 放开到 50MB（与 nginx client_max_body_size 对齐），否则大批次会被截断、
    // multipart 边界丢失导致整批 FormData 解析失败。
    proxyClientMaxBodySize: '50mb',
  },
  outputFileTracingExcludes: {
    '*': [
      'vault/**/*',
      'src-tauri/**/*',
      '.git/**/*',
    ],
  },
  async rewrites() {
    const port = process.env.NEXT_PUBLIC_CLAUDE_CHAT_PORT || '8082';
    return [
      {
        source: '/notes-claude/:path*',
        destination: `http://127.0.0.1:${port}/:path*`,
      },
    ];
  },
  webpack(config, { dev }) {
    // Limit parallel workers to reduce peak memory during build
    config.parallelism = 1;
    if (!dev) {
      // Reduce minifier memory usage by disabling parallel minification
      if (config.optimization?.minimizer) {
        config.optimization.minimizer.forEach((m: { options?: { minimizer?: { options?: { parallel?: boolean } } } }) => {
          if (m?.options?.minimizer?.options) {
            m.options.minimizer.options.parallel = false;
          }
        });
      }
    }
    return config;
  },
};

export default withPWA({
  dest: 'public',
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development' || process.env.DISABLE_PWA === '1',
  workboxOptions: {
    disableDevLogs: true,
  },
})(nextConfig);
