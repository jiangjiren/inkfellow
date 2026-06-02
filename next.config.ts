import path from 'path';
import type { NextConfig } from 'next';
import withPWA from '@ducanh2912/next-pwa';

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  outputFileTracingExcludes: {
    '*': ['node_modules/**/*'],
  },
  webpack(config, { dev }) {
    // Limit parallel workers to reduce peak memory during build
    config.parallelism = 1;
    if (!dev) {
      // Reduce minifier memory usage by disabling parallel minification
      if (config.optimization?.minimizer) {
        config.optimization.minimizer.forEach((m: any) => {
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
