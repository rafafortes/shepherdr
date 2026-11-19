// The Host allowlist: loopback always, the published names the operator sets in app.hosts, nothing else.
import { describe, expect, test } from 'bun:test'
import { hostAllowed, loopbackHosts, parseHosts, refusedHosts } from '../server/hosts.ts'

describe('the Host allowlist', () => {
  test('configured names come from a comma-separated setting, any case, with a scheme or trailing slash', () => {
    expect(parseHosts(' app.example.com, HTTPS://Other.Example:8443/ , , ')).toEqual(['app.example.com', 'other.example:8443'])
    expect(parseHosts('')).toEqual([])
  })

  test('loopback names work on the port the server listens on, and so do configured names', () => {
    const port = 7787
    expect(loopbackHosts(port)).toEqual(['127.0.0.1:7787', 'localhost:7787', '[::1]:7787'])
    for (const h of loopbackHosts(port)) expect(hostAllowed(h, port, [])).toBe(true)
    expect(hostAllowed('app.example.com', port, ['app.example.com'])).toBe(true)
    expect(hostAllowed('APP.EXAMPLE.COM.', port, ['app.example.com'])).toBe(true)
    // the helper's Unix-socket transport writes a bare name, with no port: a browser page there still sends its port
    expect(hostAllowed('shepherdr', port, [])).toBe(true)
    expect(hostAllowed(`shepherdr:${port}`, port, [])).toBe(false)
    expect(hostAllowed('evil.example:7787', port, ['app.example.com'])).toBe(false)
    expect(hostAllowed('evil.example:7787', port, [])).toBe(false)
    // a local port forward keeps the front port in Host: still loopback, so still a program, never a rebound page
    expect(hostAllowed('127.0.0.1:7788', port, [])).toBe(true)
    expect(hostAllowed('localhost:9999', port, [])).toBe(true)
    expect(hostAllowed('localhost.evil.example:7787', port, [])).toBe(false)
    refusedHosts.add('x.example')
    expect([...refusedHosts]).toEqual(['x.example'])
    refusedHosts.clear()
  })
})
