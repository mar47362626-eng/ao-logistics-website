const registerForm = document.querySelector('#admin-register-form');
const registerStatus = document.querySelector('#admin-register-status');

registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  const values = new FormData(registerForm);
  const submit = registerForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api.request('/api/auth/admin/register', {
      method: 'POST',
      body: JSON.stringify({
        name: values.get('name'),
        email: values.get('email'),
        phone: values.get('phone') || '',
        password: values.get('password'),
      }),
    });
    window.location.replace('/admin');
  } catch (error) {
    api.setStatus(registerStatus, error.message);
  } finally {
    submit.disabled = false;
  }
});
