import type { Algorithm } from './types';

export interface CategoryConfig {
  label: string;
  icon: string;
  color: string;
}

export const APP_CONFIG = {
  appName: 'JD 面试题库',
  appNameShort: 'JD面试题',
  appIcon: '📝',
  appVersion: '1.0',
  storagePrefix: 'interview-jd',
  githubUrl: 'https://sunarthur86.github.io/interview-jd/',
  repoUrl: 'https://github.com/SunArthur86/interview-jd',
  themeColor: '#0071e3',
  categories: {
    'all':         { label: '全部',            icon: '📚', color: '#0071e3' },
    'ant-risk':    { label: '蚂蚁风控 Java',   icon: '🐜', color: '#ff3b30' },
    'pdd-scm':     { label: '拼多多·供应链',    icon: '🏭', color: '#e02e24' },
    'pdd-trade':   { label: '拼多多·交易核心',  icon: '🛒', color: '#ff6c44' },
    'pdd-content': { label: '拼多多·内容社区',  icon: '📱', color: '#34c759' },
    'pdd-ai':      { label: '拼多多·AI 中台',   icon: '🤖', color: '#af52de' },
    'java-architect': { label: 'Java 后端架构师', icon: '🏗️', color: '#5856d6' },
  } as Record<string, CategoryConfig>,
  subcatGroups: {
    // 各 JD 内部统一的能力维度小分组（subcategory 通过 getSubcatGroup 映射）
    'JD 核心技术':    ['Java 并发', 'JVM', 'Java 集合', 'Spring Cloud', 'Spring Boot', '微服务', 'MySQL', 'Redis', 'HBase', 'ES', 'Kafka', '分库分表', '供应链', '商品', '交易', '订单', '用户', '评价', '直播', '中台', '规则引擎', '特征工程', '实时计算', '风控系统', '数据隔离', '系统解耦', '分布式事务'],
    '架构设计':       ['架构设计', '供应链架构', '交易架构', '多活容灾', '网关设计', '内容架构', '直播架构', 'Feed 流', '搜索架构', '中台架构', '风控架构设计', '特征平台设计', '决策引擎设计', '关系网络设计', '设备指纹设计', '安全架构'],
    '高并发高可用':   ['池化', '缓存', '扩容', '异步', '队列', '限流', '降级', '负载均衡', '隔离', '压测', '预案', '回滚', '可观测性', '稳定性治理', '高可用'],
    'AI Agent/Infra': ['Agent 改造', 'Agent 架构', 'Agent 工程化', 'LLM 训练', 'LLM 推理', '模型服务', 'RAG 工程', '多模态', '实验平台', '智能风控', 'LLM 风控', 'GraphRAG', 'FDE 解决方案', 'AI Harness'],
  } as Record<string, string[]>,
  aboutText: 'JD 面试题库 v1.0\n针对一线大厂 JD（岗位描述）深度拆解，每份 JD 对应一道大题（含 40 道子题）。\n首个 JD：蚂蚁集团国际风控平台 Java 研发工程师（35-50K·16薪）\n覆盖 JD核心技术 · 架构设计 · 高并发高可用 · AI Agent/Infra\n费曼快记 + 第一性原理 + 层层递进深度问答',
} as const;

export const SUBCAT_REVERSE: Record<string, string> = {};
Object.entries(APP_CONFIG.subcatGroups).forEach(([g, subs]) => {
  subs.forEach((s) => {
    SUBCAT_REVERSE[s] = g;
  });
});

export function getSubcatGroup(sub: string | undefined): string {
  return (sub && SUBCAT_REVERSE[sub]) || '其他';
}

export const ALGO_LABELS: Record<Algorithm, string> = {
  sm2: 'SM-2 智能间隔',
  leitner: 'Leitner 卡盒',
  ebbinghaus: '艾宾浩斯曲线',
};
