// 模板示例数据：浏览器预览注入 localStorage；桌面版由 Rust 在数据库播种。

export interface Template {
  id: number;
  title: string;
  category: string | null;
  content: string;
  file_type: string | null;
  built_in: number;
}

export const SAMPLE_TEMPLATES: Template[] = [
  {
    id: 1,
    title: "授权委托书",
    category: "授权文书",
    content:
      "委托人：________，身份证号：________。\n受托人：________，执业证号：________。\n\n现委托上述受托人在我方与________纠纷一案中，作为我方________阶段的委托代理人。\n代理权限：一般代理 / 特别授权（代为承认、放弃、变更诉讼请求，进行和解，提起反诉或者上诉，接收法律文书等）。\n\n委托人（签名）：________\n____年__月__日",
    file_type: "txt",
    built_in: 1,
  },
  {
    id: 2,
    title: "民事起诉状",
    category: "诉讼文书",
    content:
      "原告：姓名____，性别____，住址________，联系方式________。\n被告：姓名____，性别____，住址________，联系方式________。\n\n诉讼请求：\n一、判令被告……\n二、本案诉讼费由被告承担。\n\n事实与理由：\n……\n\n此致\n________人民法院\n\n具状人：____\n____年__月__日",
    file_type: "txt",
    built_in: 1,
  },
  {
    id: 3,
    title: "劳动仲裁申请书",
    category: "劳动仲裁",
    content:
      "申请人：____，住址________。\n被申请人：________公司，住所地________。\n\n仲裁请求：\n一、要求被申请人支付____元；\n二、要求被申请人________。\n\n事实与理由：\n……\n\n此致\n________劳动人事争议仲裁委员会\n\n申请人：____\n____年__月__日",
    file_type: "txt",
    built_in: 1,
  },
  {
    id: 4,
    title: "律师函模板",
    category: "函件",
    content:
      "致：________\n本所受________委托，就贵方________事宜，出具本律师函如下：\n一、事实概述……\n二、法律依据……\n三、律师意见/催告……\n\n请贵方于本函送达后____日内________，逾期本所将依委托人授权采取法律途径。\n\n特此函告。\n\n________律师事务所\n____年__月__日",
    file_type: "txt",
    built_in: 1,
  },
  {
    id: 5,
    title: "房屋租赁合同（简）",
    category: "合同",
    content:
      "出租方（甲方）：____；承租方（乙方）：____。\n\n第一条 房屋基本情况：位于________。\n第二条 租赁期限：自____年__月__日至____年__月__日。\n第三条 租金及支付：每月人民币____元，于每月__日前支付。\n第四条 定金及押金：____。\n第五条 双方权利义务：……\n第六条 违约责任：……\n\n甲方：____　乙方：____\n____年__月__日",
    file_type: "txt",
    built_in: 1,
  },
];

const LS_KEY = "workbench:templates";

export function readLocalTemplates(): Template[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Template[];
  } catch {
    /* ignore */
  }
  localStorage.setItem(LS_KEY, JSON.stringify(SAMPLE_TEMPLATES));
  return SAMPLE_TEMPLATES;
}

export function writeLocalTemplates(list: Template[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}