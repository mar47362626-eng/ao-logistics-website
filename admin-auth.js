const returnTo = `${window.location.pathname}${window.location.search}`;
const adminLoginUrl = `admin-login.html?returnTo=${encodeURIComponent(returnTo)}`;

document.body.style.visibility = 'hidden';
window.adminSessionReady = api.request('/api/auth/admin/me')
  .then(result => {
    document.body.style.visibility = '';
    return result.user;
  })
  .catch(error => {
    if (error.status === 401 || error.status === 403) {
      window.location.replace(adminLoginUrl);
    } else {
      document.body.style.visibility = '';
    }
    throw error;
  });

document.querySelector('#admin-sign-out')?.addEventListener('click', async () => {
  const button = document.querySelector('#admin-sign-out');
  button.disabled = true;
  try {
    await api.request('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    window.location.replace('admin-login.html');
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
});
