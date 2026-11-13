import { expectTypeOf, it } from 'vitest';

it('runs the Vitest typecheck mode', () => {
  expectTypeOf<'a'>().toExtend<string>();
});
