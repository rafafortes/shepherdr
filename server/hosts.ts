// Which Host headers the web app answers to. It listens on loopback and is reached from the phone through the
// operator's own reverse proxy. A page that DNS-rebinds a foreign name to 127.0.0.1 would otherwise pass sameSite():
// its Origin and Host both name its own host, so every guard there agrees. Refusing a Host that is neither a loopback
// name on our own port nor one the operator named closes that hole (upstream 3.x's service/auth.ts answers 421 the
// same way). The published name is a setting, never written in this repository.

/** the comma-separated names one may publish, as a setting names them */
export function parseHosts(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, ''))
    .filter(Boolean)
}

/** the loopback names always accepted, with the port the server actually listens on */
export const loopbackHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]

/** The helper's shepherdr command writes Host: shepherdr on its Unix socket (helper/shepherdr); an SSH remote forward
 *  carries those bytes unchanged to the worker's HTTP port, so the app sees that bare name. It has no port: a browser
 *  at http://shepherdr:7787 would send Host: shepherdr:7787 and is still refused. */
const HELPER_HOST = 'shepherdr'

/** whether a request's Host is one the app serves. A local TCP forward (the helper's SSH relay, a port proxy) keeps
 *  the front port in Host, so any loopback port is accepted: a browser cannot name a loopback address it does not run
 *  on, and its Origin still has to match. */
export function hostAllowed(host: string, port: number, configured: string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === HELPER_HOST || configured.includes(h) || loopbackHosts(port).includes(h)) return true
  const name = h.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** refused hosts, named by the 421 page, the server log (once each), doctor and the health screen */
export const refusedHosts = new Set<string>()
