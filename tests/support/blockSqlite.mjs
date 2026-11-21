// Loaded with `node --import`: makes importing node:sqlite an error, so a module that would need it
// on a Node that has none (20.19) fails here too, on a Node that has it.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:sqlite' || specifier === 'sqlite') throw new Error('node:sqlite was imported')
    return nextResolve(specifier, context)
  },
})
