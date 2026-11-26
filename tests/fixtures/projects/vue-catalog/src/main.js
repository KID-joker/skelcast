import {createApp,defineAsyncComponent} from 'vue';
import {routes} from './routes.js';
import './global.css';
createApp(defineAsyncComponent(routes[0].component)).mount('#root');
