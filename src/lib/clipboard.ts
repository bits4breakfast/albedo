/**
 * Copy text to the clipboard. Resolves true when it worked.
 *
 * `navigator.clipboard` first; WebKit can refuse it outside a user gesture or
 * an allowed origin, so a hidden-textarea `execCommand('copy')` is the
 * fallback. Never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
