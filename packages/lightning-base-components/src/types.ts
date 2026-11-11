// The shape of the `lightning-*` base components' definitions in components.generated.ts.

/** A property, method or event, with its TypeScript type. */
export interface LightningMember {
  readonly type: string;
  readonly description?: string;
}

export interface LightningComponent {
  readonly description?: string;
  /** Properties, by the name LWC sets (`max-length` sets `maxLength`), with the types they accept. */
  readonly properties: Readonly<Record<string, LightningMember>>;
  readonly methods: Readonly<Record<string, LightningMember>>;
  /** Events, by the name `on<name>` handles, with the event's type. */
  readonly events: Readonly<Record<string, LightningMember>>;
}
