/* Runs the Unbake engine off the main thread so large sheets never freeze the page. */
importScripts('engine.js' + self.location.search);
self.onmessage = (e) => {
  try {
    const result = self.Unbake.analyze(e.data.text, {
      onProgress: (fraction, column) => self.postMessage({ type: 'progress', fraction, column }),
    });
    self.postMessage({ type: 'done', result: self.Unbake.dehydrate(result) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
