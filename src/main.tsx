import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import ProjectStudio from './project/ProjectStudio';
import { ErrorBoundary } from './project/ErrorBoundary';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing in index.html');
createRoot(rootEl).render(
  <ErrorBoundary>
    <ProjectStudio />
  </ErrorBoundary>,
);
