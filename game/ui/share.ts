/**
 * "Challenge a friend" (GAME-16): Web Share API where available, else copy to the clipboard.
 * Inside a cross-origin iframe, share needs allow="web-share" on the iframe; without it the
 * call is refused and we fall back to copying.
 */

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand("copy")) resolve();
      else reject(new Error("copy failed"));
    } catch (error) {
      reject(error);
    } finally {
      ta.remove();
    }
  });
}

/** Resolves "shared", "copied" or "cancelled"; rejects when neither works. */
export async function shareOrCopy(data: {
  title: string;
  text: string;
  url: string;
}): Promise<"shared" | "copied" | "cancelled"> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share(data);
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // NotAllowedError (iframe without web-share) and others: fall through to copying.
    }
  }
  await copyText(`${data.text} ${data.url}`);
  return "copied";
}
