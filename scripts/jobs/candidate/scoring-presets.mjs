// The parts of the scoring rules that depend on a profession. Backend is what
// the scorer was calibrated on; generic works for any role from search.focusRole.
const PRESETS = {
  backend: () => ({
    closeRole: 'backend-heavy role',
    roleScope: 'roleScope: 5 = hands-on Backend engineering is the main work. 4 = mostly Backend with some full-stack/DevOps. 3 = Backend is about half of the role. 2 = Backend is minor (mainly frontend, mobile, QA, support, pre-sales). 1 = not an engineering role.',
    roleCap: 'A role that is mainly frontend, mobile, QA, or IT/DevOps operations without backend development: roleScope <= 2 and domainMatches false.',
  }),
  generic: (focusRole) => {
    const role = focusRole || 'the target role';
    return {
      closeRole: 'role',
      roleScope: `roleScope: 5 = ${role} is the main work. 4 = mostly ${role} with some adjacent work. 3 = ${role} is about half of the role. 2 = ${role} is minor. 1 = a different profession.`,
      roleCap: `A role that is mainly something other than ${role}: roleScope <= 2 and domainMatches false.`,
    };
  },
};

export function rolePreset({ rolePreset: name, focusRole } = {}) {
  return (PRESETS[name] ?? PRESETS.generic)(focusRole);
}
