const repo=process.argv[2];
if(!repo||!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)){console.error('Укажи реальный публичный репозиторий: npm run deploy:button -- https://github.com/USER/REPO');process.exitCode=1}else{console.log('https://deploy.workers.cloudflare.com/?url='+encodeURIComponent(repo.replace(/\/$/,'')))}
