export interface Command { readonly name: string; do(): void; undo(): void; }
