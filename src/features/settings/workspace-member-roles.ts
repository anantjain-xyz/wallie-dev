export const ROLE_OPTIONS = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

export function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
