/* global document, location, magpie */
(async () => {
  try {
    await magpie.ready;
    const options = await magpie.options.get();
    const target = magpie.service || `http://127.0.0.1:${options.port || 3487}/`;
    location.replace(target);
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
})();
