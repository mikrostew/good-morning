# good-morning

Manually run automated tasks in the morning.

I use this to update my system and get everything ready to go before I start work.

## Installation

(you may need to make `/usr/local/lib` and `/usr/local/bin` writeable first)

```
cd /usr/local/lib/
git clone git@github.com:mikrostew/good-morning.git
cd good-morning/
yarn
ln -s /usr/local/lib/good-morning/bin/good-morning-wrapper /usr/local/bin/good-morning-wrapper
ln -s /usr/local/lib/good-morning/bin/good-morning /usr/local/bin/good-morning
```
