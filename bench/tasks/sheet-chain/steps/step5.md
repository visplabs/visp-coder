Big sheets are a problem in the spreadsheet engine in this repository. Fill the whole grid with one long chain, where `A1` is a number, `A2` is `=A1+1`, and so on down each column and on to the top of the next one (`B1` is `=A99+1`) through `Z99`, then read every cell: today this takes far too long and then crashes.

Reading every cell of that sheet after building it should take a couple of seconds at most, with every value right, and changing `A1` afterwards and reading `Z99` should be quick too. Everything else should work as it does now.
