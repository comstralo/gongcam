// 통합 테스트 전용 더미 서비스 계정 — getServiceAccountAccessToken이
// env.GOOGLE_SERVICE_ACCOUNT_JSON을 JSON.parse해 RSA 개인키로 JWT에
// 서명한 뒤 OAuth 토큰 엔드포인트로 fetch한다. 실제 fetch는 mock하면
// 되지만, 그 이전 단계(JSON.parse, crypto.subtle.importKey("pkcs8", ...))
// 는 진짜로 유효한 PKCS8 개인키가 있어야 통과한다 — 아무 서비스와도
// 통신하지 않는 테스트 전용 키(node의 crypto.generateKeyPairSync로 1회
// 생성)이므로 실제 Google 계정과는 무관하다.
const TEST_PRIVATE_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6eW4D/AeaxA6i\nXC7Dz6pu98ZEhgMYwsVXpLbHske3TWMGkQ55P7IL8N2Q5GUfmsdthtXQS/Z++zb6\nSlPOJSz1gQQs8QXxSNQEN9xiAO3LidiKtr9gmW0zQX9y9SYov5OslB+SMOoQ2QId\n+Sto5P/Td1MXRMFcaMyr1p+OkCxSVKteYnE46XWqqG6zFSL3lInbZfVhilju9UGe\nIzIjt9VXsnkiESY7CqFrKz6ZUOFlphNxrCu2Vg0gDQP7uAn43wD88m8o1nGZJLqW\n+0OG0LXfJSQrLTpMcsSe5yAkEbt0COkhlTacf6x5IMq+9fvfKl9JU5dpSvQv+E87\nTJxyE2qZAgMBAAECggEAIKrPLCGFz4YTLjxJ8QG7UM9VS4HSnw7X9X+kiZ1g1OrY\nszjMOU+ASHk8x3pLgNrjnvtlD6WPHDW0LurAfbejharBaYIb0WY5xjdnA0A4aFTQ\nu5RCOJEIQVdzFVd/BNpy62PTmA+7oZHyvf99rFWZv5kC1Gu2GBM/78ackyQMr6ta\n1dgZAL3MSFzedRAkPgSj3Bi/O7xoqzp3mAsq3jb6Zb38rEtYgY8suotGt5fuIUCk\nswZh6olR8xSwh2aG5WWtdltJKpAuD5a7QGUjJtxmXyktcUSox9rfTuHz+KjZMNJi\nn0NSKClyHkos4LlsfAmUcw2vcnUZQQTD+Cf4euO7kQKBgQDpbDuZ4V6k/7THsozP\nORQyasgxjCdFiC/XcQHEt9kkVr2foc74+R/Lo+CW7obtgKg9Ey6KPOn/QNLcZHZ1\n5jwV7EzHhYVKlZpjMu6T4Lo1YpiG13ESi+yASUA0sh+bY04qR8IQjJ1+9wEbTK2S\nKIOHkp+vWQBjjO5Wsg4Pi0CD5QKBgQDMgrWSfX9UzOhlYaXjF7HeFFABaLdJA2Mh\nYpsV8F3GU5sAvRvI2l+2lxstY7B4/EaBtkwb3kT0mYhW0L0IwiazaMA+jV5LTB/D\nCpUdFgKVuUanN6M5sLNqiTiG6dKCrFUUkjSxGYwaNFINWCSqQUwloUtAj2BEYEd3\n25dTYG5IpQKBgA29s1yBqeKosum2lxdz0r6NDq/sAjvToo1aN7Ju6Dd9a7hD/D0n\n3TlNsmDwNb0xf7XotSqqH1RJaqBSwa57GTppKLPuJkSXvfjs/KJz7kJKRZRahmuD\nFS8QINl5SucI14chpkj3HiZlQAltYCJkhCms9f2Kjb1OhJFR9gXwOqIJAoGAbJtt\nueIT4QEA2fZFlphayUmYQ2dNDuVRm8U1/yyrYEu+IWJMgxoVgm407KHochfnibM6\nMAKWNB/lG9W2zhPtYZHbplyFGw/OPlI8ZjnuHX1LXDpb4KNKZOWCs4MxXFwQwt/y\nQ6sBkFkAyj1pG1GaEtHZmOuLgERxL+HaN1kauFECgYEAl7BYZnvbFv/1Iauh9WbO\nSUDN92Ufkr+Mr4SkxcnmtejhOKei1cFwC0nYBpOcPIXYQFhB+NZTFJvfs8F8lEP5\nqHX+k0L6ocUtD/FjMOLMohjCNonfCEzfDhhmGCV3GmDnNZ8tCxDvKxWiwGxJJvtr\n5vmICnu2Iu8NEF1r/kZR2R8=\n-----END PRIVATE KEY-----\n";

export const TEST_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "test-service-account@test.iam.gserviceaccount.com",
  private_key: TEST_PRIVATE_KEY_PEM,
});

// getServiceAccountAccessToken이 최종적으로 도달하는 fetch(OAuth 토큰
// 엔드포인트)에 대한 mock 응답. URL 매칭에 이 상수를 그대로 쓰면 된다.
export const OAUTH_TOKEN_URL_MARKER = "oauth2.googleapis.com";

export function oauthTokenResponse(accessToken = "dummy-access-token") {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }));
}
