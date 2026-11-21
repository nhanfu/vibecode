import './api'
import { hydrateUserStore } from './localPref'

// The saved preferences come out of the database first: the modules read them while they load.
hydrateUserStore().finally(() => import('./boot'))
