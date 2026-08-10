import { randomUUID } from "node:crypto"

// Streamable HTTP resumability only needs a short replay window. Bound it so
// an idle long-running Claude session cannot grow the daemon heap forever.
export class BoundedEventStore {
  constructor(maxEvents = 1_000) {
    this.maxEvents = maxEvents
    this.events = new Map()
  }

  async storeEvent(streamId, message) {
    const eventId = randomUUID()
    this.events.set(eventId, { streamId, message })
    while (this.events.size > this.maxEvents) {
      this.events.delete(this.events.keys().next().value)
    }
    return eventId
  }

  async getStreamIdForEventId(eventId) {
    return this.events.get(eventId)?.streamId
  }

  async replayEventsAfter(lastEventId, { send }) {
    const last = this.events.get(lastEventId)
    if (!last) return ""
    let replay = false
    for (const [eventId, event] of this.events) {
      if (eventId === lastEventId) {
        replay = true
        continue
      }
      if (replay && event.streamId === last.streamId) await send(eventId, event.message)
    }
    return last.streamId
  }
}
