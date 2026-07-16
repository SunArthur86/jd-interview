import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.NODE_ENV === 'production' ? '/interview-jd' : '',
  assetPrefix: process.env.NODE_ENV === 'production' ? '/interview-jd/' : undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
