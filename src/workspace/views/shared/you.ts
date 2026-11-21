import { createContext } from 'react';
import type { Actor } from '../../../files/types';

/** Who is using the app, as a server's records name them (`ServerInfo.you`): "Edited by you".
 * Absent in the browser and on folders, where nobody is named. */
export const YouContext = createContext<Actor | undefined>(undefined);
