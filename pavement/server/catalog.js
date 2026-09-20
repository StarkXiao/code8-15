// 病害字典（民用机场道面常见病害；类型编码沿用 PCI 调查习惯，中文名可按机场口径改）
export const DEFECT_TYPES = [
  { code: 'crack_long',   name: '纵向裂缝', surface: ['AC', 'PCC'] },
  { code: 'crack_trans',  name: '横向裂缝', surface: ['AC', 'PCC'] },
  { code: 'crack_map',    name: '网裂/龟裂', surface: ['AC'] },
  { code: 'crack_block',  name: '块状裂缝', surface: ['AC'] },
  { code: 'pothole',      name: '坑槽',     surface: ['AC'] },
  { code: 'raveling',     name: '松散剥落', surface: ['AC'] },
  { code: 'rutting',      name: '车辙',     surface: ['AC'] },
  { code: 'settlement',   name: '沉陷',     surface: ['AC', 'PCC'] },
  { code: 'shoving',      name: '推移/拥包', surface: ['AC'] },
  { code: 'bleeding',     name: '泛油',     surface: ['AC'] },
  { code: 'corner_break', name: '板角断裂', surface: ['PCC'] },
  { code: 'slab_crack',   name: '面板断裂', surface: ['PCC'] },
  { code: 'joint_seal',   name: '接缝填缝料损坏', surface: ['PCC'] },
  { code: 'spalling',     name: '边角剥落', surface: ['PCC'] },
  { code: 'faulting',     name: '错台',     surface: ['PCC'] },
  { code: 'pumping',      name: '唧泥',     surface: ['PCC'] },
  { code: 'fod',          name: '外来物(FOD)', surface: ['AC', 'PCC'] },
  { code: 'marking',      name: '标志标线损坏', surface: ['AC', 'PCC'] },
  { code: 'other',        name: '其他',     surface: ['AC', 'PCC'] },
];

export const SEVERITIES = [
  { code: 'low', name: '轻度' },
  { code: 'medium', name: '中度' },
  { code: 'high', name: '重度' },
];

export const DEFECT_STATUSES = [
  { code: 'open', name: '未处理' },
  { code: 'repaired', name: '已修复' },
  { code: 'closed', name: '已关闭' },
];

export function typeName(code) {
  return DEFECT_TYPES.find((t) => t.code === code)?.name ?? code;
}
export function severityName(code) {
  return SEVERITIES.find((s) => s.code === code)?.name ?? code;
}
export function statusName(code) {
  return DEFECT_STATUSES.find((s) => s.code === code)?.name ?? code;
}
