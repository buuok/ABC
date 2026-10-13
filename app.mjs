// 双击启动的入口：开本地界面并自动打开浏览器。打包成独立程序（exe / Mac 启动器）时用它。
import { spawn } from 'node:child_process';
import { startServer } from './server.mjs';

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // 打不开也没关系，窗口里打印了地址
  }
}

console.log('声音统一 正在启动…\n');
startServer(Number(process.env.VOICE_UNIFY_PORT ?? 8765))
  .then(({ url }) => {
    console.log('\n浏览器会自动打开；如果没有，请手动打开上面的地址。');
    console.log('用完后直接关闭这个窗口即可退出。');
    if (!process.env.VOICE_UNIFY_NO_BROWSER) openBrowser(url);
  })
  .catch((e) => {
    console.error(`启动失败：${e.message}`);
    setTimeout(() => process.exit(1), 60000); // 留一分钟让人看清错误
  });
