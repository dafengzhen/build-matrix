const target = process.argv[2];

if (target === 'modern') {
  console.log('Modern target passed');
} else {
  console.error(`Unsupported target: ${target}`);
  process.exitCode = 1;
}
