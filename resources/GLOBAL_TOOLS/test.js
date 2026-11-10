/* 拾光 v2 适配脚本：正方学生课表页面的实验课导入。
 * 基于用户提供的嘉兴大学页面结构，不应视为所有正方系统的通用适配。
 * 在已登录、已查询目标学期的教务网页中运行；无需填写账号密码。
 */
(function () {
  'use strict';
  const clean = s => String(s == null ? '' : s).replace(/\u00a0/g, ' ').trim();
  function ranges(value, max, parityAllowed = false) {
    const text = clean(value).replace(/[，、]/g, ',').replace(/[－—–~～]/g, '-')
      .replace(/（/g, '(').replace(/）/g, ')').replace(/周/g, '');
    const result = new Set();
    for (const part of text.split(',')) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?\s*(?:\(([单双])\))?$/);
      if (!m || (!parityAllowed && m[3])) throw new Error('无法识别时间范围：' + value);
      const a = Number(m[1]), b = Number(m[2] || m[1]);
      if (a < 1 || b < a || b > max) throw new Error('时间范围超出有效值：' + value);
      for (let i = a; i <= b; i++) {
        if (m[3] === '单' && i % 2 === 0 || m[3] === '双' && i % 2 === 1) continue;
        result.add(i);
      }
    }
    if (!result.size) throw new Error('时间范围为空：' + value);
    return [...result].sort((a, b) => a - b);
  }
  function sectionBlocks(text) {
    const values = ranges(text, 30), blocks = [];
    for (const n of values) {
      const last = blocks[blocks.length - 1];
      if (last && last[1] + 1 === n) last[1] = n;
      else blocks.push([n, n]);
    }
    return blocks;
  }
  function parseLab(row) {
    const text = clean(row.sksjdd).replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/［/g, '[').replace(/］/g, ']');
    const pattern = /星期([一二三四五六日天])\s*\[([^\]]+)\]\s*([^\n]*?)(?=星期[一二三四五六日天]\s*\[|$)/g;
    const out = [];
    let m, remainder = text;
    while ((m = pattern.exec(text))) {
      remainder = remainder.replace(m[0], '');
      const info = m[2].match(/^(.+节)\s*(.+周)\s*$/);
      if (!info) throw new Error('实验时间格式未识别：' + m[2]);
      const day = '一二三四五六日'.indexOf(m[1] === '天' ? '日' : m[1]) + 1;
      const weeks = ranges(info[2], 60, true);
      const courseName = clean(row.kcmc), project = clean(row.xmmc);
      if (!courseName && !project) throw new Error('实验课程名称为空');
      for (const [startSection, endSection] of sectionBlocks(info[1].replace(/节/g, ''))) {
        out.push({name: '[实验] ' + (courseName && project ? courseName + ' · ' + project : courseName || project),
          teacher: clean(row.jsxm), position: clean(row.dycdxq) || clean(m[3]),
          day, weeks, startSection, endSection});
      }
    }
    if (!out.length || remainder.replace(/[;；\s]/g, '')) {
      throw new Error('实验安排存在未识别内容：' + text);
    }
    return out;
  }
  function dedupe(courses) {
    const map = new Map();
    for (const c of courses) {
      const key = JSON.stringify([c.name, c.teacher, c.position, c.day, c.startSection, c.endSection]);
      const old = map.get(key);
      if (old) old.weeks = [...new Set([...old.weeks, ...c.weeks])].sort((a, b) => a - b);
      else map.set(key, {...c, weeks: [...c.weeks]});
    }
    return [...map.values()];
  }
  function parseNormal(doc) {
    const out = [];
    for (const cell of doc.querySelectorAll('[id^="kbgrid_table_"] td.td_wrap')) {
      const day = Number(cell.id.split('-')[0]);
      if (day < 1 || day > 7) continue;
      for (const item of cell.querySelectorAll('.timetable_con')) {
        const fields = [...item.querySelectorAll('p')];
        const value = i => clean(fields[i] && fields[i].textContent);
        const time = value(0).match(/[（(]([^()（）]+)节[)）]\s*(.+)/);
        const name = clean(item.querySelector('.title')?.textContent);
        if (!name || !time) throw new Error('普通课表存在无法识别的课程，请切换表格视图后重试');
        for (const [startSection, endSection] of sectionBlocks(time[1])) {
          out.push({name, day, startSection, endSection, weeks: ranges(time[2], 60, true),
            position: value(1), teacher: value(2)});
        }
      }
    }
    if (!out.length) throw new Error('未找到普通课程，请切换到表格视图并查询课表');
    return out;
  }
  async function fetchLabs($) {
    const grid = document.getElementById('sycjlrtabGrid');
    if (!grid || !grid.p) throw new Error('实验课表尚未初始化，请先查询目标学期');
    const p = grid.p;
    const url = new URL(p.url, location.href);
    if (url.origin !== location.origin) throw new Error('实验课接口必须与教务页面同源');
    const base = {...p.postData};
    // 使用课表当前已查询的参数，不从地址栏学号或个人资料构造请求。
    if (!base.xnm || !base.xqm) throw new Error('缺少已查询的学年学期参数');
    const rows = [], ids = new Set();
    let expected = null, pages = null;
    for (let page = 1; page <= (pages === null ? 1 : pages); page++) {
      const data = await $.ajax({url: url.href, type: p.mtype || 'POST', dataType: 'json', timeout: 20000,
        data: {...base, 'queryModel.showCount': 15, 'queryModel.currentPage': page,
          'queryModel.sortName': p.sortname || '', 'queryModel.sortOrder': p.sortorder || 'asc'}});
      if (!data || !Array.isArray(data.items)) throw new Error('实验接口返回异常，可能登录已过期');
      const count = Number(data.totalResult), total = Number(data.totalPage);
      if (!Number.isInteger(count) || count < 0 || !Number.isInteger(total) || total < 0 || total > 100 ||
          Number(data.currentPage) !== page || count > 0 && total < 1) throw new Error('实验分页信息无效');
      if (expected === null) { expected = count; pages = total; }
      if (expected !== count || pages !== total) throw new Error('查询期间实验记录发生变化，请重试');
      for (const row of data.items) {
        const id = clean(row.xmz_id);
        if (!id || ids.has(id)) throw new Error('实验分页返回重复或缺失的记录标识，已停止导入');
        ids.add(id); rows.push(row);
      }
    }
    if (rows.length !== expected) throw new Error('实验记录未获取完整，已停止导入');
    return rows;
  }
  async function run() {
    const bridge = window.shiguangBridgePromise;
    if (!bridge || !window.shiguangBridge) throw new Error('请在拾光适配脚本环境运行');
    if (window.__zjxuLabImportRunning) return;
    window.__zjxuLabImportRunning = true;
    try {
      const mode = await bridge.showSingleSelection('选择导入内容', JSON.stringify(['仅实验课', '普通课＋实验课']), 0);
      if (mode === null || mode < 0) return;
      const $ = window.jQuery;
      if (!$ || !$.ajax) throw new Error('教务页面未加载完成');
      const rows = await fetchLabs($);
      if (!rows.length) throw new Error('当前学期没有实验课记录');
      // 任何一行无法解析就停止，避免以成功提示掩盖漏课。
      const labs = rows.flatMap(parseLab);
      const normal = mode === 1 ? parseNormal(document) : [];
      const courses = dedupe([...normal, ...labs]);
      const yes = await bridge.showAlert('确认导入',
        `已完整获取 ${rows.length} 条实验记录，解析成 ${labs.length} 个上课时段。\n本次提交 ${courses.length} 条课程。\n实验项目会以“[实验] 课程名 · 项目名”显示。普通课表已有的实验时段可能与它们重叠，请在预览中核对。`, '继续');
      if (!yes) return;
      await bridge.saveImportedCourses(JSON.stringify(courses));
      window.shiguangBridge.showToast('课程已提交，请核对导入结果');
      window.shiguangBridge.notifyTaskCompletion();
    } catch (e) {
      await bridge.showAlert('未完成导入', clean(e.message) || '查询失败，请重新登录后重试', '确定');
    } finally { window.__zjxuLabImportRunning = false; }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {ranges, sectionBlocks, parseLab, dedupe, parseNormal, fetchLabs};
  } else { run().catch(e => console.error('实验课导入未启动', e.message)); }
})();
