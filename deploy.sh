#!/bin/sh
# Публикация сборки на сайт (хост с FastPanel).
#   DEPLOY_HOST=user@host sh deploy.sh       или положите DEPLOY_HOST=... в .deploy.env (файл не в git)
#   SKIP_BUILD=1 — не пересобирать dist/
# 1. собирает dist/ (npm run build)
# 2. заливает архив кусками по 2 МБ с ограничением скорости и повторами: хост рвёт длинные передачи
# 3. на сервере распаковывает в соседнюю папку SITE.new и подменяет сайт переименованием.
#    Если загрузка оборвалась, текущий сайт не трогается. Заглушка панели при первом деплое
#    сохраняется как SITE.orig.
set -e
cd "$(dirname "$0")"
[ -f .deploy.env ] && . ./.deploy.env
HOST=${DEPLOY_HOST:?укажите DEPLOY_HOST=user@host или положите его в .deploy.env}
WWW=${DEPLOY_WWW:-/var/www/fastuser/data/www}
SITE=${DEPLOY_SITE:-15.umolab.ru}
GROUP=${DEPLOY_GROUP:-fastuser}
TMP=${DEPLOY_TMP:-/var/www/fastuser/data/tmp}/${SITE}_deploy
LIMIT=${LIMIT:-3000}                      # ограничение scp, Кбит/с
OPTS="-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=5"

retry() { n=0; until "$@"; do n=$((n + 1)); [ $n -ge 6 ] && return 1; sleep 5; done; }

[ "$SKIP_BUILD" = 1 ] || npm run build
test -s dist/index.html && test -s dist/sw.js

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
tar -cf "$W/site.tar" -C dist .
SIZE=$(wc -c < "$W/site.tar" | tr -d ' ')
mkdir "$W/p" && split -b 2M -d -a 3 "$W/site.tar" "$W/p/p."
retry ssh $OPTS "$HOST" "rm -rf $TMP && mkdir -p $TMP"
for f in "$W"/p/p.*; do
  retry scp -q -l "$LIMIT" $OPTS "$f" "$HOST:$TMP/"
  printf '.'
done
echo
retry ssh $OPTS "$HOST" "set -e
  cd $TMP && cat p.* > site.tar && test \$(wc -c < site.tar) -eq $SIZE
  cd $WWW && rm -rf $SITE.new && mkdir $SITE.new && chgrp $GROUP $SITE.new && chmod 2775 $SITE.new
  tar -xf $TMP/site.tar -C $SITE.new --no-same-owner
  find $SITE.new -type d -exec chmod 2775 {} + && find $SITE.new -type f -exec chmod 664 {} +
  if [ -d $SITE/.well-known ]; then cp -r $SITE/.well-known $SITE.new/; fi
  if [ -e $SITE ]; then
    if [ -e $SITE.orig ]; then rm -rf $SITE.old && mv $SITE $SITE.old; else mv $SITE $SITE.orig; fi
  fi
  mv $SITE.new $SITE && rm -rf $SITE.old $TMP"
echo "опубликовано: https://$SITE/ ($SIZE байт)"
