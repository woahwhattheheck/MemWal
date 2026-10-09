/** Tracks background analyze requests, not downstream Walrus job completion. */
export class BackgroundSaves {
    private readonly pending = new Set<Promise<void>>();
    // Keep a count and one cause rather than retaining every error indefinitely
    // in a long-lived application that never calls flush().
    private failureCount = 0;
    private firstFailure: unknown;

    constructor(private readonly onFailure: (error: unknown) => void) {}

    add(save: () => Promise<unknown>): void {
        // Defer invocation so a synchronous client/adapter exception is handled
        // identically to a rejected promise, without breaking the model reply.
        const pending = Promise.resolve().then(save).then(
            () => {},
            (error: unknown) => {
                if (this.failureCount === 0) this.firstFailure = error;
                this.failureCount += 1;
                // Telemetry must not turn a handled background failure into an
                // unhandled rejection. The wrapper owns callback diagnostics.
                try { this.onFailure(error); } catch { /* failure remains recorded */ }
            },
        );
        this.pending.add(pending);
        void pending.then(() => this.pending.delete(pending));
    }

    /**
     * Await saves already started and consume recorded analyze failures once.
     * A resolved flush confirms request acceptance only, not durable storage.
     * Calls must be made after the model operation has started its saves.
     */
    async flush(): Promise<void> {
        await Promise.all([...this.pending]);
        if (this.failureCount === 0) return;
        const error = Object.assign(
            new Error(
                `${this.failureCount} Walrus Memory auto-save request(s) failed. ` +
                "Inspect the cause before retrying; a timed-out write may have been accepted.",
                { cause: this.firstFailure },
            ),
            { name: "MemWalAutoSaveError", failureCount: this.failureCount },
        );
        this.failureCount = 0;
        this.firstFailure = undefined;
        throw error;
    }
}
