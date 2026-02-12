#!/usr/bin/env node

import * as p from '@clack/prompts';
import { writeFileSync } from 'fs';
import yaml from 'js-yaml';
import jsonata from 'jsonata';
import { parseArgs } from 'util';

const DEFAULT_API_BASE = 'https://config-svc.app.trustgraph.ai/api';

// Parse command line arguments
const { values: args } = parseArgs({
  options: {
    api: {
      type: 'string',
      short: 'a',
      default: DEFAULT_API_BASE,
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    },
  },
});

if (args.help) {
  console.log(`
TrustGraph Configuration CLI

Usage: tg-config [options]

Options:
  -a, --api <url>  API base URL (default: ${DEFAULT_API_BASE})
  -h, --help       Show this help message
`);
  process.exit(0);
}

const apiBase = args.api.replace(/\/$/, '');

// Fetch helpers
const fetchYaml = async (endpoint) => {
  const url = `${apiBase}${endpoint}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return yaml.load(await response.text());
};

const fetchText = async (endpoint) => {
  const url = `${apiBase}${endpoint}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
};

const fetchDoc = async (path) => {
  const url = `${apiBase}/docs/${path}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return `*Documentation file not found: ${path}*`;
    }
    return response.text();
  } catch {
    return `*Documentation file not found: ${path}*`;
  }
};

// Evaluate JSONata condition
const evaluateCondition = async (condition, state) => {
  if (!condition) return true;
  try {
    const expr = jsonata(condition);
    return Boolean(await expr.evaluate(state));
  } catch {
    return false;
  }
};

// Find next step based on transitions
const findNextStep = async (step, state) => {
  for (const transition of step.transitions || []) {
    if (await evaluateCondition(transition.when, state)) {
      return transition.next || null;
    }
  }
  return null;
};

// Set nested value in state
const setValue = (state, key, value) => {
  const parts = key.split('.');
  let obj = state;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]]) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
};

// Prompt for a step based on input type
const promptStep = async (step) => {
  const input = step.input || {};
  const type = input.type || 'select';

  if (type === 'select') {
    // Auto-select if only one option
    if (input.options.length === 1) {
      const opt = input.options[0];
      p.log.info(`${step.title} ${opt.label}`);
      return opt.value;
    }

    const options = input.options.map(opt => ({
      value: opt.value,
      label: opt.label + (opt.recommended ? ' (Recommended)' : ''),
      hint: opt.description,
    }));
    const defaultOpt = input.options.find(opt => opt.recommended);
    return await p.select({
      message: step.title,
      options,
      initialValue: defaultOpt?.value,
    });
  }

  if (type === 'toggle') {
    return await p.confirm({
      message: step.title,
      initialValue: input.default ?? false,
    });
  }

  if (type === 'number') {
    const result = await p.text({
      message: step.title,
      initialValue: String(input.default ?? ''),
      validate: (val) => {
        const num = parseInt(val, 10);
        if (isNaN(num)) return 'Please enter a valid number';
        if (input.min !== undefined && num < input.min) return `Value must be at least ${input.min}`;
        if (input.max !== undefined && num > input.max) return `Value must be at most ${input.max}`;
      },
    });
    return parseInt(result, 10);
  }

  if (type === 'text') {
    return await p.text({
      message: step.title,
      initialValue: input.default ?? '',
      placeholder: input.placeholder,
    });
  }

  return null;
};

// Generate installation documentation
const generateDocs = async (state, docsManifest) => {
  const { documentation } = docsManifest;
  const { categories, instructions } = documentation;

  // Build category map
  const categoryMap = Object.fromEntries(categories.map(c => [c.id, c]));

  // Evaluate conditions and collect matching instructions
  const matching = [];
  const seenIds = new Set();

  for (const instruction of instructions) {
    // Check condition
    let matches = false;
    if (instruction.always) {
      matches = true;
    } else if (instruction.when) {
      matches = await evaluateCondition(instruction.when, state);
    }

    if (matches && !seenIds.has(instruction.id)) {
      seenIds.add(instruction.id);
      const cat = categoryMap[instruction.category];
      matching.push({
        ...instruction,
        categoryPriority: cat?.priority ?? 99,
        categoryTitle: cat?.title ?? instruction.category,
      });
    }
  }

  // Sort by category priority, then instruction priority
  matching.sort((a, b) => {
    if (a.categoryPriority !== b.categoryPriority) {
      return a.categoryPriority - b.categoryPriority;
    }
    return (a.priority ?? 99) - (b.priority ?? 99);
  });

  // Group by category
  const grouped = {};
  for (const item of matching) {
    if (!grouped[item.category]) {
      grouped[item.category] = {
        title: item.categoryTitle,
        priority: item.categoryPriority,
        items: [],
      };
    }
    grouped[item.category].items.push(item);
  }

  // Build output
  const output = [`# ${documentation.title}\n`];

  for (const cat of Object.values(grouped).sort((a, b) => a.priority - b.priority)) {
    output.push(`\n## ${cat.title}\n`);

    for (const item of cat.items) {
      if (item.goal) {
        output.push(`\n### ${item.goal}\n`);
      }
      if (item.file) {
        const content = await fetchDoc(item.file);
        output.push(content);
      }
    }
  }

  return output.join('\n');
};

// Format state for review display
const formatState = (obj, prefix = '') => {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      lines.push(...formatState(value, fullKey));
    } else {
      const displayValue = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
      lines.push(`  ${fullKey}: ${displayValue}`);
    }
  }
  return lines;
};

// Main wizard
const main = async () => {
  console.clear();

  p.intro('TrustGraph Configuration');

  // Load resources from API
  const s = p.spinner();
  s.start(`Loading from ${apiBase}...`);

  let flowData, outputTemplate, docsManifest;
  try {
    flowData = await fetchYaml('/dialog-flow');
    const outputTemplateText = await fetchText('/config-prepare');
    outputTemplate = jsonata(outputTemplateText);
    docsManifest = await fetchYaml('/docs-manifest');
    s.stop('Resources loaded');
  } catch (err) {
    s.stop('Failed to load resources');
    p.log.error(err.message);
    process.exit(1);
  }

  p.log.info(flowData.flow.title);

  const state = {};
  const history = []; // Track human-readable question/answer pairs
  let currentStepId = flowData.flow.start;

  // Walk through steps
  while (currentStepId) {
    const step = flowData.steps[currentStepId];

    if (!step) {
      p.log.error(`Unknown step: ${currentStepId}`);
      break;
    }

    // Review step
    if (step.type === 'review') {
      const lines = history.map(h => `  ${h.question} ${h.answer}`);
      p.log.info('Configuration Summary:\n' + lines.join('\n'));

      // Generate config
      const s = p.spinner();
      s.start('Generating configuration...');

      const config = await outputTemplate.evaluate(state);

      s.stop('Configuration generated');

      // Prompt for filename
      const filename = await p.text({
        message: 'Save deployment package as:',
        initialValue: 'deploy.zip',
      });

      if (p.isCancel(filename)) {
        p.cancel('Cancelled');
        process.exit(0);
      }

      const s2 = p.spinner();
      s2.start('Downloading...');

      try {
        const response = await fetch(config.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config.templates),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        writeFileSync(filename, Buffer.from(buffer));
        s2.stop(`Saved to ${filename}`);
      } catch (err) {
        s2.stop('Download failed');
        p.log.error(err.message);
      }

      // Generate documentation
      const s3 = p.spinner();
      s3.start('Generating installation guide...');

      const docs = await generateDocs(state, docsManifest);

      s3.stop('Installation guide generated');

      // Prompt for docs filename
      const docsFilename = await p.text({
        message: 'Save installation guide as:',
        initialValue: 'INSTALLATION.md',
      });

      if (p.isCancel(docsFilename)) {
        p.cancel('Cancelled');
        process.exit(0);
      }

      writeFileSync(docsFilename, docs);
      p.log.success(`Saved to ${docsFilename}`);

      break;
    }

    // Regular step - prompt user
    const value = await promptStep(step);

    if (p.isCancel(value)) {
      p.cancel('Cancelled');
      process.exit(0);
    }

    // Save to state
    if (step.state_key) {
      setValue(state, step.state_key, value);

      // Record human-readable question/answer
      const input = step.input || {};
      let displayValue;
      if (input.type === 'select') {
        const opt = input.options.find(o => o.value === value);
        displayValue = opt?.label ?? value;
      } else if (input.type === 'toggle') {
        displayValue = value ? 'Yes' : 'No';
      } else {
        displayValue = String(value);
      }
      history.push({ question: step.title, answer: displayValue });
    }

    // Find next step
    currentStepId = await findNextStep(step, state);
  }

  p.outro('Done!');
};

main().catch(console.error);
