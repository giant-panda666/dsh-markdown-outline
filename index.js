/**
 * Host half of the Markdown outline bundle.
 *
 * The capability is browser-only: the Client half claims `.md` file addresses in
 * the right Sidebar, reads them through the shared `workspaceFiles` Remote, and
 * draws the outline tree and the document. This Host plugin only mounts so the
 * Loader has a row whose `dsh.client` declaration the Web carrier can serve.
 */
export function apply() {}
