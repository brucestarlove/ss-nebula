/** jsdom has no `crypto.subtle`: Node's WebCrypto and SHA-1 for the tests that need the real thing. */
type NodeCrypto = { webcrypto: Crypto; createHash(algorithm: string): { update(data: Uint8Array): { digest(encoding: 'hex'): string } } };

export async function nodeCrypto(): Promise<NodeCrypto> {
  // Not a literal, so the page's type-check and bundler leave Node's own module alone.
  return (await import(/* @vite-ignore */ ['node', 'crypto'].join(':'))) as NodeCrypto;
}
