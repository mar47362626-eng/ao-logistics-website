window.API_BASE_URL = window.API_BASE_URL || 'https://a-mlogistic.onrender.com';
const apiBaseUrl = window.API_BASE_URL.replace(/\/+$/, '');

window.api = {
  url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${apiBaseUrl}${path}`;
  },
  setStatus(element, message, state = 'error') {
    element.textContent = message;
    if (!message) {
      element.classList.remove('feedback-message');
      delete element.dataset.state;
      return;
    }
    element.classList.add('feedback-message');
    element.dataset.state = state;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  },
  async request(url, options = {}) {
    const response = await fetch(window.api.url(url), {
      credentials: 'include',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (response.status === 204) return null;
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return result;
  },
};
