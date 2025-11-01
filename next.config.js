/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/', destination: '/mirror/index.html' },
      { source: '/:path*/', destination: '/mirror/:path*/index.html' },
      { source: '/:path*', destination: '/mirror/:path*.html' }
    ];
  }
};

export default nextConfig;
