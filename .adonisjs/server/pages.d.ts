import '@adonisjs/inertia/types'

import type React from 'react'
import type { Prettify } from '@adonisjs/core/types/common'

type ExtractProps<T> =
  T extends React.FC<infer Props>
    ? Prettify<Omit<Props, 'children'>>
    : T extends React.Component<infer Props>
      ? Prettify<Omit<Props, 'children'>>
      : never

declare module '@adonisjs/inertia/types' {
  export interface InertiaPages {
    'about/show': ExtractProps<(typeof import('../../inertia/pages/about/show.tsx'))['default']>
    'auth/login': ExtractProps<(typeof import('../../inertia/pages/auth/login.tsx'))['default']>
    'auth/signup': ExtractProps<(typeof import('../../inertia/pages/auth/signup.tsx'))['default']>
    'auth/unavailable': ExtractProps<(typeof import('../../inertia/pages/auth/unavailable.tsx'))['default']>
    'duplicates/index': ExtractProps<(typeof import('../../inertia/pages/duplicates/index.tsx'))['default']>
    'errors/not_found': ExtractProps<(typeof import('../../inertia/pages/errors/not_found.tsx'))['default']>
    'errors/server_error': ExtractProps<(typeof import('../../inertia/pages/errors/server_error.tsx'))['default']>
    'home': ExtractProps<(typeof import('../../inertia/pages/home.tsx'))['default']>
    'isolation/index': ExtractProps<(typeof import('../../inertia/pages/isolation/index.tsx'))['default']>
    'releases/index': ExtractProps<(typeof import('../../inertia/pages/releases/index.tsx'))['default']>
    'repositories/show': ExtractProps<(typeof import('../../inertia/pages/repositories/show.tsx'))['default']>
    'workspaces/index': ExtractProps<(typeof import('../../inertia/pages/workspaces/index.tsx'))['default']>
    'workspaces/show': ExtractProps<(typeof import('../../inertia/pages/workspaces/show.tsx'))['default']>
  }
}
