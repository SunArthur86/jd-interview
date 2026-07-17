import './globals.css';
import ClientBootstrap from '@/components/ClientBootstrap';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'JD 面试题库',
  description: '针对一线大厂 JD（岗位描述）深度拆解的面试题库，含费曼快记、第一性原理、层层递进深度问答。首个 JD：蚂蚁国际风控 Java 研发工程师。',
  manifest: '/interview-jd/manifest.json',
};

export const viewport: Viewport = {
  themeColor: '#0071e3',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('interview-jd');var t='light';if(s){var j=JSON.parse(s);t=j.state&&j.state.theme||t;}else if(localStorage.getItem('interview-jd.theme')){t=JSON.parse(localStorage.getItem('interview-jd.theme'));}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ClientBootstrap>{children}</ClientBootstrap>
      </body>
    </html>
  );
}
