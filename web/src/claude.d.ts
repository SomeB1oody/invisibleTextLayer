/** The part of the viewer runtime that this page uses. */
interface Window {
  claude?: {
    use(name: 'downloads'): Promise<{
      save(request: { filename: string; data: Uint8Array }): Promise<{ status: string }>;
    } | null>;
  };
}
