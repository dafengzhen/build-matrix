const app = document.querySelector('#app');
if (app) {
  app.textContent = `Built in ${import.meta.env.MODE} mode by Build Matrix`;
}
