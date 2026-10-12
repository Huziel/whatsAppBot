export class PerContactRateLimiter {
  private readonly entries = new Map<string, number[]>()

  consume(contactKey: string, maxPerHour: number, now = Date.now()): boolean {
    if (!this.allows(contactKey,maxPerHour,now)) return false
    this.record(contactKey,now)
    return true
  }

  allows(contactKey: string, maxPerHour: number, now = Date.now()): boolean {
    const recent = (this.entries.get(contactKey) ?? []).filter(timestamp => now - timestamp < 60 * 60 * 1000)
    this.entries.set(contactKey,recent)
    return recent.length < maxPerHour
  }

  record(contactKey: string, now = Date.now()): void {
    const recent = (this.entries.get(contactKey) ?? []).filter(timestamp => now - timestamp < 60 * 60 * 1000)
    recent.push(now);this.entries.set(contactKey,recent)
    if (this.entries.size > 1_000) {
      for (const [key, times] of this.entries) if (!times.some(timestamp => now - timestamp < 60 * 60 * 1000)) this.entries.delete(key)
    }
  }

  clear(): void { this.entries.clear() }
  forget(contactKey: string): void { this.entries.delete(contactKey) }
}
