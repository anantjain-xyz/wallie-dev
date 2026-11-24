# Connector outbound delivery

Connector replies and edits are durable operations on an existing session
conversation source. The source namespace is the mapped resource UUID. The
thread key is the provider's immutable conversation object ID. The resource,
source, and session must belong to the same factory.

- Enqueue with a stable logical key and immutable content. An exact replay
  returns the original receipt UUID. Adapters use that UUID as their provider
  idempotency or correlation key across writes and observations.
- An edit names its preceding confirmed receipt on the same source. That
  receipt supplies the provider reply ID. One unfailed successor per receipt
  keeps later edits from racing earlier ones.
- An optional verified actor link retains the initiating human or service in
  the receipt. The worker obtains send authority from the live connector
  installation, mapping, and credential.

## Worker recovery

| State               | Worker behavior                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued              | Claim one send permit for the installation and confirm its exact authority immediately before provider I/O.                                                                        |
| Unknown             | Claim an observation permit for the same correlation key. A verified reply ID completes the receipt. Only definitive absence allows a new write.                                   |
| Blocked             | Wait for the mapping or credential to recover. A provider credential rejection requires a new installation generation. Resume observation when an earlier write remains uncertain. |
| Delivered or failed | Retain the final receipt. A confirmed reply ID can serve as the next edit target.                                                                                                  |

A permit authorizes transport once. Expiry before authorization is a known
pre-write failure. An authorized send with no settlement becomes unknown.
Observation has its own bounded attempts. Its lease, a provider rate limit, or
credential repair cannot convert uncertainty to a write. An inconclusive
provider lookup should stay unknown, including an eventually consistent miss.

The worker processes one in-flight permit per installation and honors the
installation's shared, bounded cooldown. Sending and observation have separate
retry limits within the original 24-hour deadline. Diagnostics retain the
attempt kind, generation, revision, and a closed result code. They omit provider
response bodies and secrets.

Provider integrations supply a `ConnectorOutboundAdapter` with `send` and
`observe` functions and invoke `drainConnectorOutboundDeliveries` in their
maintenance entry point. Adapters use the exact credential reference and
material revision, honor the provided abort signal, and report `not_sent` only
when they can establish that no write took place. Existing factory event
webhooks still use subscriber-side deduplication on their event IDs.
