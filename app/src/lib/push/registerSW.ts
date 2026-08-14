// 기존 admin.html의 document.baseURI 패턴과 동일한 효과.
// Vite에서는 import.meta.env.BASE_URL(=vite.config.ts의 base)로 서브패스를 인식한다.
export function swUrl(): string {
  return new URL("sw.js", window.location.origin + import.meta.env.BASE_URL).href;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(swUrl());
  await navigator.serviceWorker.ready;
  return reg;
}
