/** Runs in the guest page; clipboard contents never cross the plugin bridge. */
export function nativePasteScript(channel: string): string {
  return `(() => {
    if (!/Mac/.test(navigator.platform)) return;
    window.__tetherNativePasteCleanup?.();
    let sequence = 0;
    const pending = new Set();
    const capture = event => {
      if (!event.isTrusted || event.defaultPrevented || !event.metaKey || event.ctrlKey ||
          event.altKey || event.shiftKey || event.key.toLowerCase() !== 'v') return;
      const field = event.target;
      if (!field?.matches?.('textarea,input') || field.disabled || field.readOnly ||
          (field.tagName === 'INPUT' && !['text','search','url','tel','password','email','number'].includes(field.type))) return;
      // Append after Paseo's preload listener so its shortcut policy gets first refusal.
      const completed = next => {
        window.removeEventListener('keydown', completed);
        pending.delete(completed);
        if (next !== event || event.defaultPrevented || !event.cancelable ||
            !field.isConnected || document.activeElement !== field || field.disabled || field.readOnly) return;
        event.preventDefault();
        console.debug(${JSON.stringify(channel)} + (++sequence));
      };
      pending.add(completed);
      window.addEventListener('keydown', completed);
      // A page may stop propagation before the window bubbling phase.
      setTimeout(() => { window.removeEventListener('keydown', completed); pending.delete(completed); }, 0);
    };
    window.addEventListener('keydown', capture, true);
    window.__tetherNativePasteCleanup = () => {
      window.removeEventListener('keydown', capture, true);
      for (const listener of pending) window.removeEventListener('keydown', listener);
      pending.clear();
    };
  })()`;
}
