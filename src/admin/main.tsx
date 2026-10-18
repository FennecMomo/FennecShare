import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp';
import './admin.css';

const container = document.getElementById('admin-root');
if (!container) throw new Error('缺少 #admin-root 挂载节点');

createRoot(container).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
