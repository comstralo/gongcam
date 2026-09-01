// 서버(handlePushSubscribe)가 구독 키를 `sub:${email}:${sha256Hex(endpoint)}`
// 형태로 저장하는 것과 동일한 해시를 브라우저에서 계산한다 — "지금 이
// 브라우저가 기기 목록 중 어느 항목인지"를 알아내는 데 쓴다(자기 자신을
// 지울 때만 브라우저 쪽 구독도 함께 해지하기 위함).
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
