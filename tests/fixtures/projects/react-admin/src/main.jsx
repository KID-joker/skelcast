import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { routes } from './routes.js';
import './global.css';
const Page = lazy(routes[0].component);
createRoot(document.getElementById('root')).render(<Suspense fallback={null}><Page /></Suspense>);
