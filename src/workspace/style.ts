// The workspace's styles, in the order they must cascade. The app's own
// layers come first (tokens, base, backgrounds and ss-ui's element-wide
// button and input chrome), so workspace.css can neutralise that chrome for
// the workspace's controls at equal specificity. Import this module rather
// than the CSS files, and keep CSS out of the exported components.
import '../nebula/style';
import '@starlove/ui/templates/sidebar';
import '@starlove/ui/components/context-menu';
import '@starlove/ui/components/kbd';
import '@starlove/ui/components/slider';
import './fonts.css';
import './workspace.css';
import './signals.css';
import './history.css';
